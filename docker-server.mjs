import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handler as contact } from './netlify/functions/contact.js';
import { handler as checkout } from './netlify/functions/create-checkout-session.js';
import { handler as checkoutSession } from './netlify/functions/get-checkout-session.js';
import { handler as health } from './netlify/functions/health.js';
import { handler as webhook } from './netlify/functions/webhook.js';
import { handler as agentIntake } from './netlify/functions/agent-intake.js';
import { handler as agentAdmin } from './netlify/functions/agent-admin.js';
import { runOnce as agentRunOnce } from './netlify/functions/agent-runner.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8080);
const maxBodyBytes = 1024 * 1024;
const functions = new Map([
  ['/api/contact', contact],
  ['/.netlify/functions/contact', contact],
  ['/api/create-checkout-session', checkout],
  ['/.netlify/functions/create-checkout-session', checkout],
  ['/api/checkout-session', checkoutSession],
  ['/.netlify/functions/get-checkout-session', checkoutSession],
  ['/api/health', health],
  ['/.netlify/functions/health', health],
  ['/api/webhook', webhook],
  ['/.netlify/functions/webhook', webhook],
  ['/api/agent-intake', agentIntake],
  ['/.netlify/functions/agent-intake', agentIntake],
  ['/api/agent-admin', agentAdmin],
  ['/.netlify/functions/agent-admin', agentAdmin],
  // Not scheduled here — hit this path to process one task locally.
  ['/.netlify/functions/agent-runner', async () => ({ statusCode: 200, body: await agentRunOnce() })]
]);
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const handler = functions.get(pathname);

    if (handler) {
      const body = await readBody(request);
      const result = await handler({
        httpMethod: request.method,
        headers: request.headers,
        queryStringParameters: Object.fromEntries(url.searchParams),
        body,
        isBase64Encoded: false
      });
      response.writeHead(result.statusCode || 200, { ...securityHeaders, ...result.headers });
      response.end(result.body || '');
      return;
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      send(response, 405, 'Method not allowed');
      return;
    }

    const aliases = { '/': '/index.html', '/pricing': '/pricing.html', '/contact': '/contact.html', '/privacy': '/privacy.html', '/terms': '/terms.html', '/favicon.ico': '/favicon.svg', '/admin': '/admin.html' };
    const requested = aliases[pathname] || pathname;
    const relative = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = join(root, relative);

    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      send(response, 404, 'Not found');
      return;
    }

    response.writeHead(200, {
      ...securityHeaders,
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch (error) {
    const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 500;
    send(response, status, status === 413 ? 'Request body too large' : 'Internal server error');
  }
}).listen(port, host, () => console.log(`Bucurie Digital listening on http://${host}:${port}`));

function send(response, status, body) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
