import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Clients persist an install ID (and consent files) under the user's
// config directory. Point it at a throwaway directory so no test ever
// writes into the real one.
const configDir = mkdtempSync(join(tmpdir(), 'argvio-test-config-'))
process.env['XDG_CONFIG_HOME'] = configDir
process.env['APPDATA'] = configDir
process.env['HOME'] = configDir
