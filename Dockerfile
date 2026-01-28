FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["npm","start"]
