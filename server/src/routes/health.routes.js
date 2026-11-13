import { Router } from 'express'
import { getDatabaseStatus } from '../config/db.js'

const router = Router()

router.get('/', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'reliable-job-queue-api',
    database: getDatabaseStatus(),
  })
})

export default router

