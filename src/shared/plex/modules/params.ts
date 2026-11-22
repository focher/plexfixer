/**
 * Module parameters: the numbers and switches a check or repair is tuned by.
 *
 * A module says what it can be tuned by — the kind of value, its label, its
 * limits — and `default.json` says what each one is set to out of the box.
 * The values never live in code, so there is one place the shipped behaviour
 * is written down and "Reset" has exactly one thing to go back to.
 */

import type { ParamValue } from '../catalog/types.js'

export type { ParamValue }

interface Base {
  label: string
  help?: string
}

export interface Option<T> {
  value: T
  label: string
}

export type ParamSpec =
  | (Base & { type: 'number'; min?: number; max?: number; step?: number; unit?: string; options?: readonly Option<number>[] })
  | (Base & { type: 'boolean' })
  | (Base & { type: 'string'; options?: readonly Option<string>[] })
  | (Base & { type: 'list'; options?: readonly Option<string>[] })

/** In editor order. */
export type ParamSchema = Readonly<Record<string, ParamSpec>>

/** The value type each kind of spec resolves to. */
type ValueOf<S extends ParamSpec> = S extends { type: 'number' }
  ? number
  : S extends { type: 'boolean' }
    ? boolean
    : S extends { type: 'list' }
      ? readonly string[]
      : string

export type ParamValues<S extends ParamSchema = ParamSchema> = { readonly [K in keyof S]: ValueOf<S[K]> }

/** Whether a value is one this spec accepts. */
export function validateParam(spec: ParamSpec, value: unknown): value is ParamValue {
  switch (spec.type) {
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (spec.min === undefined || value >= spec.min) &&
        (spec.max === undefined || value <= spec.max) &&
        (spec.options === undefined || spec.options.some((option) => option.value === value))
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return (
        typeof value === 'string' &&
        (spec.options === undefined || spec.options.some((option) => option.value === value))
      )
    case 'list':
      return (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string') &&
        (spec.options === undefined || value.every((item) => spec.options?.some((option) => option.value === item)))
      )
  }
}

/**
 * The values a module runs with.
 *
 * Each parameter takes the configured value when it is valid, and the shipped
 * one otherwise — an edit that went wrong, or a setting from a build whose
 * limits were different, costs that one parameter and nothing else.
 */
export function resolveParams<S extends ParamSchema>(
  schema: S,
  shipped: Readonly<Record<string, unknown>> | undefined,
  configured: Readonly<Record<string, unknown>> | undefined
): ParamValues<S> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, spec]) => {
      const mine = configured?.[key]
      return [key, validateParam(spec, mine) ? mine : shipped?.[key]]
    })
  ) as ParamValues<S>
}

/** Problems with the shipped values for a schema: each spec needs one, and it has to be valid. */
export function shippedParamProblems(
  id: string,
  schema: ParamSchema,
  shipped: Readonly<Record<string, unknown>> | undefined
): string[] {
  const values = shipped ?? {}
  return [
    ...Object.entries(schema)
      .filter(([key, spec]) => !validateParam(spec, values[key]))
      .map(([key]) => `${id}.params.${key}: default.json has no valid value`),
    ...Object.keys(values)
      .filter((key) => !(key in schema))
      .map((key) => `${id}.params.${key}: default.json sets a parameter the module does not have`)
  ]
}
