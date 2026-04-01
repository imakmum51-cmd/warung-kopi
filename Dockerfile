FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Buat folder untuk SQLite database persistent
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=/data/warkop.db

EXPOSE 8080

CMD ["node", "app.js"]
