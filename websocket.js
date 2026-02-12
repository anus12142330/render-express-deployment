import { WebSocketServer } from 'ws';

let wss;

export function initializeWebSocket(server) {
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        console.log('Client connected to WebSocket');

        ws.on('close', () => {
            console.log('Client disconnected');
        });

        ws.on('error', (error) => {
            console.error('WebSocket Error:', error);
        });
    });

    console.log('WebSocket server initialized.');
}

export function broadcast(data) {
    if (!wss) {
        console.error("WebSocket server not initialized.");
        return;
    }

    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(message);
        }
    });
}
