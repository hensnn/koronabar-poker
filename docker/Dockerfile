# Sestavení: klient (Vite) a server (esbuild), potom lehký běhový obraz.
FROM node:22-alpine AS build
RUN npm i -g pnpm@12.11.2
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @kb/web build && pnpm --filter @kb/server build
# Jen produkční závislosti serveru (interní balíčky jsou zabalené v dist).
RUN pnpm --filter @kb/server deploy --legacy --prod /deploy

FROM node:22-alpine
WORKDIR /app
# ffmpeg: ořez a normalizace hlasitosti nahrávaných zvukových emotikonů; tzdata: české časové pásmo (TZ).
RUN apk add --no-cache ffmpeg tzdata
ENV NODE_ENV=production \
    TZ=Europe/Prague \
    PORT=3000 \
    WEB_DIR=/app/web \
    PGLITE_DIR=/data/pglite \
    MASTER_KEY_FILE=/data/master.key \
    SOUNDS_DIR=/data/sounds \
    ANNOUNCER_DIR=/data/announcer
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./web
RUN mkdir -p /data/sounds /data/announcer && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
