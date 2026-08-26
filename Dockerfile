FROM node:20-slim

WORKDIR /app

COPY . .
RUN npm ci
RUN npm run build

EXPOSE 3010
CMD ["npm", "start"]
