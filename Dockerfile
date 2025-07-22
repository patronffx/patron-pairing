FROM node:lts-buster

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    libwebp-dev && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

COPY package.json .

RUN npm install && npm install -g qrcode-terminal pm2

COPY . .

EXPOSE 5000

CMD ["npm", "start"]
