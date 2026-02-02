#!/usr/bin/env node
/**
 * Generate Google Ads API refresh token
 * Run: node scripts/get-refresh-token.js YOUR_CLIENT_ID
 */

import http from 'http';
import { URL } from 'url';

const clientId = process.argv[2];

if (!clientId) {
  console.error('Usage: node scripts/get-refresh-token.js YOUR_CLIENT_ID');
  process.exit(1);
}

const SCOPES = 'https://www.googleapis.com/auth/adwords';
const REDIRECT_PORT = 8087;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n=== Google Ads API Refresh Token Generator ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in with your Google account that has Google Ads access');
console.log('3. After authorizing, you will be redirected back here\n');
console.log(`Waiting for callback on port ${REDIRECT_PORT}...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h1>Error: No authorization code received</h1>');
    return;
  }

  // Exchange code for tokens
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error: ${tokens.error}</h1><p>${tokens.error_description}</p>`);
      console.error('Token error:', tokens);
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Success!</h1><p>You can close this window. Check your terminal for the refresh token.</p>');

    console.log('\n=== SUCCESS ===\n');
    console.log('Add this to your .env file:\n');
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    server.close();
    process.exit(0);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error exchanging code</h1><p>${error.message}</p>`);
    console.error('Error:', error);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT);
