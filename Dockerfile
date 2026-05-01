# Small production image for the sword prototype.
# Build: docker build -t sword .
# Run:   docker run -p 8080:8080 sword
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
