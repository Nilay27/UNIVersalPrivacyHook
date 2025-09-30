FROM node:22

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
RUN npm install

COPY . .

# Build TypeScript
RUN npm run build

# Start both services (helper + operator)
CMD ["npm", "run", "start:all"]
