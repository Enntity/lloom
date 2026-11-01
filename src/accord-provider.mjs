// The provider stays on loopback even when inference binds a private network IP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomicJson } from './deployment-fence.mjs';
import { effectAuthorized } from './accord-resources.mjs';
export function createAccordProvider({ tokenFile, handle }) {
  const file = path.join(path.dirname(tokenFile), 'accord-provider.json');
  let port = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).port : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid Accord provider port');
  let flight;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    try {
      const match = /^\/gateway\/accord\/resources\/([^/]+)\/(prepare|stop|restore|start|inspect|availability)$/.exec(
        req.url
      );
      if (req.method !== 'POST' || !match || !effectAuthorized(req, tokenFile))
        throw Object.assign(Error('Accord provider credential required'), { statusCode: 403 });
      const chunks = [];
      let bytes = 0;
      for await (const b of req) {
        bytes += b.length;
        if (bytes > 32768) throw Object.assign(Error('Body too large'), { statusCode: 413 });
        chunks.push(b);
      }
      const result = await handle(
        decodeURIComponent(match[1]),
        match[2],
        JSON.parse(Buffer.concat(chunks).toString() || '{}')
      );
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = e.statusCode || 409;
      res.end(JSON.stringify({ error: { code: e.code || 'provider_unconfirmed', message: e.message } }));
    }
  });
  server.requestTimeout = 30000;
  return {
    async listen() {
      if (server.listening) return port;
      if (flight) return flight;
      flight = new Promise((resolve, reject) => {
        const error = (e) => {
          server.off('listening', ready);
          reject(e);
        };
        const ready = async () => {
          server.off('error', error);
          port = server.address().port;
          try {
            await writeAtomicJson(file, { schema: 1, port });
            resolve(port);
          } catch (e) {
            server.close();
            reject(e);
          }
        };
        server.once('error', error);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      }).finally(() => {
        flight = null;
      });
      return flight;
    },
    async close() {
      if (flight) await flight.catch(() => {});
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  };
}
