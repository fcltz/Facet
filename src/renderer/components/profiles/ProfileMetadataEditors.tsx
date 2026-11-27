import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProfilePatchInput } from '@shared/schemas/profile'
import { GroupSelect, TagPicker } from '@renderer/components/common/pickers'
import { toastError } from '@renderer/lib/ipc'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'

function useSave(id: string) {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const save = async (patch: ProfilePatchInput) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    try {
      await useProfilesStore.getState().update(id, patch)
    } catch (error) {
      toastError(error)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return { busy, save }
}

export function ProfileTagsEditor({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const { busy, save } = useSave(row.id)
  return (
    <TagPicker
      compact
      disabled={busy}
      label={t('profileView.editTags', { name: row.name })}
      value={row.tagIds}
      onChange={(tagIds) => void save({ tagIds })}
    />
  )
}

export function ProfileGroupEditor({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const { busy, save } = useSave(row.id)
  return (
    <GroupSelect
      compact
      disabled={busy}
      label={t('profileView.editGroup', { name: row.name })}
      value={row.groupId}
      onChange={(groupId) => void save({ groupId })}
    />
  )
}
