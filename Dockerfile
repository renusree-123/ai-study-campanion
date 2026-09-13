# Base image with Node.js 20
FROM node:20-slim AS base

# Install openssl for Prisma compatibility
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy full application code
COPY . .

# Generate Prisma client and build Next.js app
ENV NODE_ENV=production
RUN npx prisma generate
RUN npm run build

# Expose Next.js server port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run Prisma schema push & start Next.js production server
CMD ["sh", "-c", "npx prisma db push && npm start"]
