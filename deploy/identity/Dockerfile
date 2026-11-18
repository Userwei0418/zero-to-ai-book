FROM node:22-bookworm-slim
WORKDIR /app
RUN install -d -m 0700 -o node -g node /var/lib/book-identity
COPY accounts.mjs server.mjs provision.mjs ./deploy/identity/
USER node
EXPOSE 8080
CMD ["node", "deploy/identity/server.mjs"]
