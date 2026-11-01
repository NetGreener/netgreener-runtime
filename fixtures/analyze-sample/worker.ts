import { Queue } from 'bullmq'

const queue = new Queue('demo')
await queue.add('nightly_report', { organization_id: 'org_demo' })
