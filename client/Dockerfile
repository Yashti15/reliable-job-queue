# Stage 1: Build React / Vite application
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve with lightweight Nginx
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY nginx.conf /etc/nginx/conf.d/default.conf

ENV PORT=80 \
    API_URL=http://api:5000

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
