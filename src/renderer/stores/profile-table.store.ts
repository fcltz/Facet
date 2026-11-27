import { create } from 'zustand'
import {
  DEFAULT_PROFILE_TABLE,
  type OptionalProfileColumn,
  type ProfileTablePreferences,
  type ResizableProfileColumn,
} from '@shared/schemas/profile-table'
import { invoke, toastError } from '@renderer/lib/ipc'
import { PROFILE_COLUMN_LAYOUT } from '@renderer/lib/profile-table-layout'
import { useSettingsStore } from './settings.store'

interface TableState {
  preferences: ProfileTablePreferences
  pending: boolean
  setVisible: (column: OptionalProfileColumn, visible: boolean) => void
  setWidth: (column: ResizableProfileColumn, width: number | null) => void
  reset: () => void
}
let revision = 0
let writes = Promise.resolve()

function save(preferences: ProfileTablePreferences): void {
  const version = ++revision
  useProfileTableStore.setState({ preferences, pending: true })
  writes = writes.then(async () => {
    if (version !== revision) return
    try {
      const saved = await invoke('settings.update', { profileTable: preferences })
      useSettingsStore.getState().apply(saved)
    } catch (error) {
      toastError(error)
    } finally {
      if (version === revision)
        useProfileTableStore.setState({
          preferences: useSettingsStore.getState().settings.profileTable,
          pending: false,
        })
    }
  })
}

export const useProfileTableStore = create<TableState>()((_, get) => ({
  preferences: DEFAULT_PROFILE_TABLE,
  pending: false,
  setVisible: (column, visible) =>
    save({
      ...get().preferences,
      hidden: visible
        ? get().preferences.hidden.filter((id) => id !== column)
        : [...new Set([...get().preferences.hidden, column])],
    }),
  setWidth: (column, width) => {
    const widths = { ...get().preferences.widths }
    if (width === null) delete widths[column]
    else
      widths[column] = Math.min(
        32000,
        Math.max(PROFILE_COLUMN_LAYOUT.find((item) => item.id === column)!.min, Math.round(width)),
      )
    save({ ...get().preferences, widths })
  },
  reset: () => save({ hidden: [], widths: {} }),
}))

useSettingsStore.subscribe((state, previous) => {
  if (
    state.settings.profileTable !== previous.settings.profileTable &&
    !useProfileTableStore.getState().pending
  )
    useProfileTableStore.setState({ preferences: state.settings.profileTable })
})
