import net from 'node:net';

/** Ask the OS for a free loopback TCP port (or verify a requested one). */
export function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (err) => {
      if (preferred) freePort(0).then(resolve, reject);
      else reject(err);
    });
    srv.listen(preferred, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
