var fs = require("fs");
var http = require("http");
var path = require("path");

var sessions = {};
var usersInSessionLimit = 2;
var usersInWaitingListLimit = 10;

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
    function keepAlive(resp) {
        if (resp) {
            resp.write(":\n");
            resp.keepAliveTimer = setTimeout(arguments.callee, 30000, resp);
        }
    }
    function kill(resp) {
        if (resp) {
            clearTimeout(resp.keepAliveTimer);
            resp.end();
        }
    }
    function closeAll(mSessionId) {
        console.log("@" + mSessionId + " - Call closeAll().");
        var mSession = sessions[mSessionId];
        if (!mSession) return;
        if (mSession.v) {
            mSession.v.esResponse.write("event:quit\ndata:" + mSession.v.username + "\n\n");
            kill(mSession.v.esResponse);
        }
        if (mSession.h) {
            mSession.h.esResponse.write("event:quit\ndata:" + mSession.h.username + "\n\n");
            kill(mSession.h.esResponse);
        }
        for (var pname in mSession.waitingList) {
            mSession.waitingList[pname].esResponse.write("event:quit\ndata:" + pname + "\n\n");
            kill(mSession.waitingList[pname].esResponse);
        }
        delete sessions[mSessionId];
    }
            
    var headers = {
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "Expires": "0"
    };

    var parts = request.url.split("/");
    var sessionId = parts[2];
    var userId = parts[3];
    if (!sessionId || !userId) {
        response.writeHead(400);
        response.write("event:quit\ndata:\n\n");
        response.end();
        return;
    }

    switch (parts[1]) {
        
        case "vjoin":
            headers["Content-Type"] = "text/event-stream";
            response.writeHead(200, headers);
            
            var session = sessions[sessionId];
            if (session && session.v) { // rejoin or wrong room
                if (session.v.username === userId) { // rejoin
                    kill(session.v.esResponse);
                    session.v.esResponse = response;
                    keepAlive(response);
                    console.log("@" + sessionId + " - " + userId + " rejoin.");
                } else {
                    response.write("event:quit\ndata:\n\n");
                    response.end();
                    console.log("@" + sessionId + " - " + userId + " fail to join an occupied session.");
                }
                return;
            }
            if (!session) { // vi arrive first
                session = sessions[sessionId] = {
                    users: {},
                    v: null,
                    h: null,
                    waitingList: {},
                    namelist: function () {
                        var namelist = [];
                        for (var pname in this.waitingList) {
                            namelist.push({
                                username: pname,
                                rate: this.waitingList[pname].rate
                            });
                        }
                        return namelist;
                    },
                    started: false
                };
            }
            
            console.log("@" + sessionId + " - " + userId + " joined as v.");
            
            session.v = {
                username : userId,
                esResponse : response
            };
            session.users[userId] = session.v;
            keepAlive(response);
            
            response.write("event:refresh\ndata:" + JSON.stringify(session.namelist()) + "\n\n");

            request.on("finish", function () { console.log("on finish"); });
            request.on("abort", function () { console.log("on abort"); });
            request.on("close", function () {
                clearTimeout(response.keepAliveTimer);
                session.started = true;
                closeAll(sessionId);
                console.log("@" + sessionId + " - " + userId + " vi leave and close session.");
            });
            
            return;
        case "hjoin":
            headers["Content-Type"] = "text/event-stream";
            response.writeHead(200, headers);
            
            var session = sessions[sessionId];
            if (!session) { // helper arrive first
                session = sessions[sessionId] = {
                    users: {},
                    v: null,
                    h: null,
                    waitingList: {},
                    namelist: function () {
                        var namelist = [];
                        for (var pname in this.waitingList) {
                            namelist.push({
                                username: pname,
                                rate: this.waitingList[pname].rate
                            });
                        }
                        return namelist;
                    },
                    started: false
                };
            }
            
            if (session.started) {
                console.log("Session " + sessionId + " has started");
                response.write("event:quit\ndata:\n\n");
                response.end();
                return;
            }
            
            if (Object.keys(session.waitingList).length >= usersInWaitingListLimit) {
                console.log("Session " + sessionId + " reached helper limit(" + usersInWaitingListLimit + ")");
                response.write("event:quit\ndata:\n\n");
                response.end();
                return;
            }
                
            console.log("@" + sessionId + " - Add " + userId + " into waiting list");
                
            session.waitingList[userId] = {
                username: userId,
                esResponse: response,
                rate: parts[4]
            };
            keepAlive(response);
            
            if (session.v) {
                session.v.esResponse.write("event:refresh\ndata:" + JSON.stringify(session.namelist()) + "\n\n");
            }
                
            request.on("finish", function () { console.log("on finish"); });
            request.on("abort", function () { console.log("on abort"); });
            request.on("close", function () {
                clearTimeout(response.keepAliveTimer);
                if (session && !session.started && session.v) {
                    session.v.esResponse.write("event:refresh\ndata:" + JSON.stringify(session.namelist()) + "\n\n");
                }
                console.log("@" + sessionId + " - " + userId + " helper leave.");
            });
            
            return;
        case "ctos":
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
            
            return;
        case "vquit":
            var session = sessions[sessionId];
            if (!session) {
                response.writeHead(400, headers);
                response.end();
                return;
            }
            
            if (session.v && session.v.username === userId) {
                console.log("@" + sessionId + " - " + userId + " vi quit.");
                closeAll(sessionId);
            }
            
            return;
        case "hquit":
            var session = sessions[sessionId];
            if (!session) {
                response.writeHead(400, headers);
                response.end();
                return;
            }
            
            if (session.h && session.h.username === userId && session.started) {
                console.log("@" + sessionId + " - " + userId + " helper online quit.");
                closeAll(sessionId);
            } else {
                if (session.waitingList[userId]) {
                    session.waitingList[userId].esResponse.write("event:quit\ndata:" + userId + "\n\n");
                    kill(session.waitingList[userId].esResponse);
                    delete session.waitingList[userId];
                    console.log("@" + sessionId + " - " + userId + " helper on list quit.");
                    if (session.v) {
                        session.v.esResponse.write("event:refresh\ndata:" + JSON.stringify(session.namelist()) + "\n\n");
                    }
                }
            }
            
            return;
        case "select":
            var session = sessions[sessionId];
            if (!session) {
                response.writeHead(400, headers);
                response.end();
                return;
            }
            
            var helper = session.waitingList[userId];
            if (helper) {
                console.log("@" + sessionId + " - Select " + userId + ".");
                session.started = true;
                session.h = helper;
                session.users[userId] = session.h;
                
                var vResp = session.v.esResponse;
                var hResp = helper.esResponse;
                clearTimeout(vResp.keepAliveTimer);
                keepAlive(vResp);
                vResp.write("event:join\ndata:" + userId + "\n\n");
                hResp.write("event:join\ndata:" + session.v.username + "\n\n");
                
                delete session.waitingList[userId];
                for (var pname in session.waitingList) {
                    session.waitingList[pname].esResponse.write("event:quit\ndata:" + pname + "\n\n");
                    kill(session.waitingList[pname].esResponse);
                }
                session.waitingList = {};
            }
            
            return;
        default:
            return;
    }

});

console.log('The server is listening on port ' + port);
server.listen(port);
