import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma 7 moved the connection URL out of schema.prisma. Migrate/introspect
// read it from here; the runtime client gets it via a driver adapter (see
// src/lib/db.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
})
