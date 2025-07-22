# Use maintained Node.js base image with Debian Bullseye
FROM node:lts-bullseye

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    libwebp-dev && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# Copy package.json first to install dependencies
COPY package.json .

# Install Node.js dependencies globally and locally
RUN npm install && npm install -g qrcode-terminal pm2

# Copy all other project files
COPY . .

# Expose port your app uses
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
