const http = require('http');
const url = require('url');
const {Server} = require('ws');

const SocketPort = 20110;
const ROUTERS = {
    '/scratch/ble': require('./session/ble')
};

const httpServer = http.createServer()
    .listen(SocketPort, '127.0.0.1', () => {
        console.log('socket server listend: ', `http://127.0.0.1:${SocketPort}`);
    });
const socketServer = new Server({server: httpServer});

socketServer.on('connection', (socket, request) => {
    const {pathname} = url.parse(request.url);
    const Session = ROUTERS[pathname];
    let session;
    if (Session) {
        session = new Session(socket);
    } else {
        return socket.close();
    }
    const dispose =  () => {
        if (session) {
            session.dispose();
            session = null;
        }
    };
    socket.on('close', dispose);
    socket.on('error', dispose);
});