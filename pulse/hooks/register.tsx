import type { Register } from 'claude-code'

import { registerPulse } from '../pulse'

export const register: Register = on => registerPulse(on)
