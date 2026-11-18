FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build:container

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 SQLITE_PATH=/data/course.sqlite
COPY --from=build /app/.next/standalone/ ./
COPY --from=build /app/.next/static/ ./.next/static/
COPY --from=build /app/public/ ./public/
COPY --from=build /app/drizzle/ ./drizzle/
COPY --from=build /app/deploy/web/sqlite.mjs /app/deploy/web/migrate.mjs ./deploy/web/
RUN mkdir -p /data .next/cache && chown node:node /data .next/cache
USER node
EXPOSE 3000
CMD ["sh", "-c", "node deploy/web/migrate.mjs && exec node server.js"]
