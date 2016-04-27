var fs = require("fs");
var http = require("http");
var path = require("path");

var sessions = {};
var usersInSessionLimit = 2;

var port = process.env.PORT || 24679;
if (process.argv.length == 3) {
    port = process.argv[2];
}

var serverDir = path.dirname(__filename)
var clientDir = path.join(serverDir, "client/");

var contentTypeMap = {
    ".html": "text/html;charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css"
};

var server = http.createServer(function (request, response) {
    var headers = {
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "Expires": "0"
    };

    var parts = request.url.split("/");

    // handle "client to server" and "server to client"
    if (parts[1] == "ctos" || parts[1] == "stoc" || parts[1] == "kickoff") {
        var sessionId = parts[2];
        var userId = parts[3];
        if (!sessionId || !userId) {
            response.writeHead(400);
            response.end();
            return;
        }

        if (parts[1] == "stoc") {
            console.log("@" + sessionId + " - " + userId + " joined.");

            headers["Content-Type"] = "text/event-stream";
            response.writeHead(200, headers);
            function keepAlive(resp) {
                resp.write(":\n");
                resp.keepAliveTimer = setTimeout(arguments.callee, 30000, resp);
            }
            keepAlive(response);  // flush headers + keep-alive

            var session = sessions[sessionId];
            if (!session)
                session = sessions[sessionId] = {
                    "users" : {},
                    "waitingList" : [],
                    "waitingResp" : [],
                    "waitingIndex" : 0,
                    "started" : false
                };

            if (Object.keys(session.users).length > usersInSessionLimit - 1) {
                if (session.started) {
                    console.log("user limit for session reached (" + usersInSessionLimit + ")");
                    response.write("event:busy\ndata:" + sessionId + "\n\n");
                    clearTimeout(response.keepAliveTimer);
                    response.end();
                    return;
                } else {
                    console.log("Add user " + userId + " into waiting list");
                    session.waitingList.push(userId);
                    session.waitingResp.push(response);
                    return;
                }
            }

            var user = session.users[userId];
            if (!user) {
                user = session.users[userId] = {};
                for (var pname in session.users) {
                    var esResp = session.users[pname].esResponse;
                    if (esResp) {
                        clearTimeout(esResp.keepAliveTimer);
                        keepAlive(esResp);
                        esResp.write("event:join\ndata:" + userId + "\n\n");
                        response.write("event:join\ndata:" + pname + "\n\n");
                    }
                }
            }
            else if (user.esResponse) {
                user.esResponse.end();
                clearTimeout(user.esResponse.keepAliveTimer);
                user.esResponse = null;
            }
            user.esResponse = response;

            request.on("finish", function () { console.log("on finish"); });
            request.on("abort", function () { console.log("on abort"); });
            request.on("close", function () {
                for (var pname in session.users) {
                    if (pname == userId)
                        continue;
                    var esResp = session.users[pname].esResponse;
                    esResp.write("event:leave\ndata:" + userId + "\n\n");
                }
                delete session.users[userId];
                clearTimeout(response.keepAliveTimer);
                console.log("@" + sessionId + " - " + userId + " left.");
                console.log("users in session " + sessionId + ": " + Object.keys(session.users).length);
            });

        } else if (parts[1] == "ctos") {
            var peerId = parts[4];
            var peer;
            var session = sessions[sessionId];
            if (!session || !(peer = session.users[peerId])) {
                response.writeHead(400, headers);
                response.end();
                return;
            }

            var body = "";
            request.on("data", function (data) { body += data; });
            request.on("end", function () {
                console.log("@" + sessionId + " - " + userId + " => " + peerId + " :");
                // console.log(body);
                var evtdata = "data:" + body.replace(/\n/g, "\ndata:") + "\n";
                peer.esResponse.write("event:user-" + userId + "\n" + evtdata + "\n");
            });

            // to avoid "no element found" warning in Firefox (bug 521301)
            headers["Content-Type"] = "text/plain";
            response.writeHead(204, headers);
            response.end();
        } else { // parts[1] == "kickoff"
            var session = sessions[sessionId];
            if (!session) {
                response.writeHead(400, headers);
                response.end();
                return;
            }
            var user = session.users[userId];
            if (user) {
                if (user.esResponse) {
                    user.esResponse.write("event:kicked\ndata:data\n\n");
                    user.esResponse.end();
                    clearTimeout(user.esResponse.keepAliveTimer);
                    user.esResponse = null;
                }
                delete session.users[userId];
                for (var pname in session.users) {
                    var esResp = session.users[pname].esResponse;
                    esResp.write("event:leave\ndata:" + userId + "\n\n");
                }
                console.log("@" + sessionId + " - " + userId + " left.");
                console.log("users in session " + sessionId + ": " + Object.keys(session.users).length);
                
                if (!session.started) {
                    if (session.waitingIndex < session.waitingList.length) {
                        var nextUser = session.waitingList[session.waitingIndex];
                        var nextResp = session.waitingResp[session.waitingIndex++];
                        var user = session.users[nextUser];
                        if (!user) {
                            user = session.users[nextUser] = {};
                            for (var pname in session.users) {
                                var esResp = session.users[pname].esResponse;
                                if (esResp) {
                                    clearTimeout(esResp.keepAliveTimer);
                                    keepAlive(esResp);
                                    esResp.write("event:join\ndata:" + nextUser + "\n\n");
                                    nextResp.write("event:join\ndata:" + pname + "\n\n");
                                }
                            }
                        } else if (user.esResponse) {
                            user.esResponse.end();
                            clearTimeout(user.esResponse.keepAliveTimer);
                            user.esResponse = null;
                        }
                        user.esResponse = nextResp;
                    }
                }
            }
        }

        return;
    } else if (parts[1] == "start") {
        var sessionId = parts[2];
        if (!sessionId) {
            response.writeHead(400);
            response.end();
            return;
        }
        var session = sessions[sessionId];
        if (!session) {
            response.writeHead(400, headers);
            response.end();
            return;
        }
        console.log("Session " + sessionId + " starts");
        
        session.started = true;
        for (var wResp in waitingResp) {
            if (wResp) {
                wResp.write("event:kicked\ndata:data\n\n");
                wResp.end();
                clearTimeout(wResp.keepAliveTimer);
            }
        }
        session.waitingList = [];
        session.waitingResp = [];
        session.waitingIndex = 0;
        
        return;
    }

    var url = request.url.split("?", 1)[0];
    var filePath = path.join(clientDir, url);
    if (filePath.indexOf(clientDir) != 0 || filePath == clientDir)
        filePath = path.join(clientDir, "/webrtc_example.html");

    fs.stat(filePath, function (err, stats) {
        if (err || !stats.isFile()) {
            response.writeHead(404);
            response.end("404 Not found");
            return;
        }

        var contentType = contentTypeMap[path.extname(filePath)] || "text/plain";
        response.writeHead(200, { "Content-Type": contentType });

        var readStream = fs.createReadStream(filePath);
        readStream.on("error", function () {
            response.writeHead(500);
            response.end("500 Server error");
        });
        readStream.pipe(response);
    });
});

console.log('The server is listening on port ' + port);
server.listen(port);
