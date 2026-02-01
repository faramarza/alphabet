# Production Deployment Guide

Deploy Alphabet Trains Google Ads Co-Pilot to a subdomain with password protection.

## Architecture

```
User → Cloudflare → Nginx (SSL) → Node.js App (port 3000)
                                  ↓
                            PostgreSQL
```

## Step 1: Server Setup

### Requirements
- Ubuntu 22.04+ or similar Linux server
- Node.js 18+
- PostgreSQL 14+
- Nginx
- Domain with DNS access

### Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install Nginx
sudo apt install -y nginx

# Install PM2 (process manager)
sudo npm install -g pm2
```

## Step 2: Database Setup

```bash
# Create PostgreSQL user and database
sudo -u postgres psql

# In PostgreSQL:
CREATE USER alphabet_user WITH PASSWORD 'your_secure_db_password';
CREATE DATABASE alphabet_trains OWNER alphabet_user;
GRANT ALL PRIVILEGES ON DATABASE alphabet_trains TO alphabet_user;
\q
```

## Step 3: Application Setup

```bash
# Create app directory
sudo mkdir -p /var/www/alphabet-trains
sudo chown $USER:$USER /var/www/alphabet-trains

# Clone or copy application
cd /var/www/alphabet-trains
git clone <your-repo-url> .
# Or scp files from your local machine

# Install dependencies
npm ci --production

# Build TypeScript
npm run build

# Create production .env
cp .env.production.example .env
nano .env  # Edit with your values
```

### Generate Secure Secrets

```bash
# Generate JWT secret (64+ characters)
echo "JWT_SECRET=$(openssl rand -hex 32)"

# Generate Admin token (32+ characters)
echo "ADMIN_TOKEN=$(openssl rand -hex 16)"

# Generate Basic Auth password
echo "BASIC_AUTH_PASS=$(openssl rand -base64 24)"
```

### Run Migrations

```bash
npm run migrate
npm run seed
```

## Step 4: DNS Setup

Add a DNS record for your subdomain:

```
Type: A
Name: copilot (or your preferred subdomain)
Value: <your-server-ip>
TTL: Auto
Proxy: Yes (if using Cloudflare)
```

Result: `copilot.alphabet-trains.com`

## Step 5: Nginx Configuration

Create Nginx config:

```bash
sudo nano /etc/nginx/sites-available/alphabet-copilot
```

```nginx
server {
    listen 80;
    server_name copilot.alphabet-trains.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name copilot.alphabet-trains.com;

    # SSL certificates (use Let's Encrypt or Cloudflare)
    ssl_certificate /etc/letsencrypt/live/copilot.alphabet-trains.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/copilot.alphabet-trains.com/privkey.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Block crawlers
    if ($http_user_agent ~* (googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebot)) {
        return 403;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # Health check endpoint (for load balancers)
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
        access_log off;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/alphabet-copilot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Step 6: SSL Certificate

### Option A: Let's Encrypt (free)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d copilot.alphabet-trains.com
```

### Option B: Cloudflare (recommended)

1. Enable Cloudflare proxy for the subdomain
2. Set SSL mode to "Full (strict)"
3. Create Origin Certificate in Cloudflare
4. Install certificate on server

## Step 7: PM2 Process Manager

Create PM2 ecosystem file:

```bash
nano /var/www/alphabet-trains/ecosystem.config.cjs
```

```javascript
module.exports = {
  apps: [
    {
      name: 'alphabet-api',
      script: 'dist/index.js',
      cwd: '/var/www/alphabet-trains',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'alphabet-worker',
      script: 'dist/worker.js',
      cwd: '/var/www/alphabet-trains',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

Start the application:

```bash
cd /var/www/alphabet-trains
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Follow the printed command to enable auto-start
```

## Step 8: Prevent Search Indexing

### robots.txt (already included)

The app serves `/robots.txt` that blocks all crawlers.

### Cloudflare Settings (if using)

1. Go to Cloudflare Dashboard → Your Domain → Rules
2. Create Page Rule:
   - URL: `copilot.alphabet-trains.com/*`
   - Setting: "Disable Apps", "Disable Performance", "Browser Integrity Check: On"

### Google Search Console

1. Go to Google Search Console
2. Add your subdomain
3. Request removal of all URLs

### Meta Tags (already in HTML)

The HTML includes no-index headers.

## Step 9: Verify Deployment

```bash
# Check if app is running
pm2 status

# Check logs
pm2 logs alphabet-api
pm2 logs alphabet-worker

# Test health endpoint
curl https://copilot.alphabet-trains.com/health

# Test with basic auth
curl -u "alphabet_admin:your_password" https://copilot.alphabet-trains.com/api/policies/current
```

## Step 10: Access the Dashboard

1. Open `https://copilot.alphabet-trains.com`
2. Enter HTTP Basic Auth credentials (browser prompt)
3. Enter Admin Token in the web UI
4. You're in!

## Security Checklist

- [ ] Strong DATABASE password
- [ ] JWT_SECRET is 64+ random characters
- [ ] ADMIN_TOKEN is 32+ random characters
- [ ] BASIC_AUTH_PASS is 16+ random characters
- [ ] SSL/TLS enabled (HTTPS only)
- [ ] Firewall allows only ports 80, 443, 22
- [ ] PostgreSQL not exposed to internet
- [ ] robots.txt blocks all crawlers
- [ ] No sensitive data in logs

## Monitoring

### PM2 Monitoring

```bash
pm2 monit
```

### Logs

```bash
# View live logs
pm2 logs

# View specific app
pm2 logs alphabet-api --lines 100
```

### Database Backup

```bash
# Create backup script
cat > /var/www/alphabet-trains/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/var/backups/alphabet"
mkdir -p $BACKUP_DIR
pg_dump -U alphabet_user alphabet_trains | gzip > "$BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S).sql.gz"
find $BACKUP_DIR -type f -mtime +7 -delete
EOF

chmod +x /var/www/alphabet-trains/backup.sh

# Add to crontab
crontab -e
# Add: 0 2 * * * /var/www/alphabet-trains/backup.sh
```

## Troubleshooting

### App won't start

```bash
# Check logs
pm2 logs alphabet-api --err

# Check environment
cat /var/www/alphabet-trains/.env

# Test database connection
psql -U alphabet_user -d alphabet_trains -c "SELECT 1;"
```

### 502 Bad Gateway

```bash
# Check if Node app is running
pm2 status

# Check Nginx config
sudo nginx -t

# Check Nginx logs
sudo tail -f /var/log/nginx/error.log
```

### SSL Issues

```bash
# Renew Let's Encrypt cert
sudo certbot renew

# Check cert expiry
sudo certbot certificates
```
