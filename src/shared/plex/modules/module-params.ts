/**
 * A module's parameters for a set of settings: the user's value where it is
 * valid, the shipped one from `default.json` otherwise.
 */

import type { AppSettings } from '../../types.js'
import { catalogFor, shippedParams } from '../catalog/resolve.js'
import type { ModuleDescription } from './framework.js'
import { resolveParams, type ParamValues } from './params.js'

export const paramsFor = (
  module: Pick<ModuleDescription, 'id' | 'params'>,
  section: 'checks' | 'repairs',
  settings: Partial<Pick<AppSettings, 'catalog'>> | undefined
): ParamValues =>
  resolveParams(module.params ?? {}, shippedParams(section, module.id), catalogFor(settings)[section][module.id]?.params)
