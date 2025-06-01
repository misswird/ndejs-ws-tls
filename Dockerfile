FROM node:16.20.0-alpine3.18

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

WORKDIR /app


COPY . .


RUN apk update \
    && apk add --no-cache shadow zsh \
    && npm install \
    && groupadd sudo \
    && echo 'node:1000' | chpasswd \
    && usermod -aG sudo node \
    && chown -R node:node / 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

USER 1000


CMD ["npm", "start"]

