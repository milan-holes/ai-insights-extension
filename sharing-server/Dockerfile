FROM node:24-slim

WORKDIR /app

COPY package.json server.js ./

RUN mkdir -p /data

ENV NODE_ENV=production \
    PORT=3000 \
    BASE_URL=http://localhost:3000 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
