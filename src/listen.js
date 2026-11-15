// Starts the HTTP server. If the chosen port is busy, tries the next ones
// in turn, so a second app on the same machine never stops this one starting.
import os from 'node:os';

export function listen(app, { port, host, attempts = 20, strict = false }) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const server = app.listen(p, host);
      server.once('listening', () => resolve({ server, port: server.address().port, requested: port }));
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && !strict && left > 1 && p < 65535) return attempt(p + 1, left - 1);
        reject(err.code === 'EADDRINUSE'
          ? new Error(strict ? `Port ${p} is already in use.` : `Ports ${port} to ${p} are all in use. Choose another with --port.`)
          : err.code === 'EACCES' ? new Error(`Not allowed to listen on port ${p}. Ports below 1024 need root; choose a higher one.`)
          : err);
      });
    };
    attempt(port, attempts);
  });
}

// Addresses other machines on the network can use to reach this one.
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export function accessUrls({ host, port }) {
  const local = `http://localhost:${port}`;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return { local, lan: [] };
  if (host !== '0.0.0.0' && host !== '::') return { local: `http://${host}:${port}`, lan: [] };
  return { local, lan: lanAddresses().map((a) => `http://${a}:${port}`) };
}
