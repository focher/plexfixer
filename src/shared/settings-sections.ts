/**
 * The sections Settings is split into.
 *
 * Settings used to be one long scroll: every section stacked, with the remote
 * host somewhere in the middle. Anything that changed how tall that column was
 * — toggling the remote host, which adds and removes fields — moved everything
 * under it, and the page could end up scrolled past its own content. One
 * section on screen at a time removes the problem rather than papering over it,
 * and it means the fields on screen are the ones the chosen section is about.
 *
 * The list lives here, away from the component, so the remembered choice can be
 * checked against it: an id from an older build, or from a storage value that
 * has been edited by hand, must not leave the pane empty.
 */

export type SettingsSectionId =
  | 'languages'
  | 'modes'
  | 'compatibility'
  | 'output'
  | 'transcoding'
  | 'remote'
  | 'ffmpeg'

export interface SettingsSection {
  id: SettingsSectionId
  /** The entry in the list on the left. */
  label: string
  /** One line under the label; the section's own heading repeats on the right. */
  hint: string
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'languages', label: 'Languages', hint: 'Which audio and subtitle tracks are default' },
  { id: 'modes', label: 'Repair modes', hint: 'What a repair may do, per folder and file' },
  { id: 'compatibility', label: 'Compatibility', hint: 'What counts as good enough to direct play' },
  { id: 'output', label: 'Output', hint: 'Where repaired files go, and backups' },
  { id: 'transcoding', label: 'Transcoding', hint: 'Encoder and quality, when a re-encode is needed' },
  { id: 'remote', label: 'Remote host', hint: 'Run the work where the files are' },
  { id: 'ffmpeg', label: 'FFmpeg', hint: 'The binaries, and which extensions are scanned' }
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = SETTINGS_SECTIONS[0].id

/** The remembered section, or the first one when it names nothing that exists. */
export function sectionFrom(stored: string | null | undefined): SettingsSectionId {
  const match = SETTINGS_SECTIONS.find((section) => section.id === stored)
  return match ? match.id : DEFAULT_SETTINGS_SECTION
}
