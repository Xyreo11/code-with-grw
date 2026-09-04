import 'dotenv/config'
import { computeAndPersist } from '../src/lib/compute'

const from = process.argv.find((a) => a.startsWith('--from='))?.split('=')[1]
const to = process.argv.find((a) => a.startsWith('--to='))?.split('=')[1]
const replace = process.argv.includes('--replace')

computeAndPersist({ from, to, replace, onProgress: (m) => console.log('  ' + m) })
  .then((r) => {
    console.log('\n--- computed ---')
    console.log('active instrument-days ' + r.activeDays)
    console.log('events persisted       ' + r.events)
    console.log('themes detected        ' + r.themes)
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
