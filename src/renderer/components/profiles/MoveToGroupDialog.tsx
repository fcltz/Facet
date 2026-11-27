import { Check, FolderX, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GroupDot } from '@renderer/components/common/GroupBadge'
import { Button } from '@renderer/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@renderer/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

function MoveToGroupBody({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { t } = useTranslation()
  const groups = useCatalogStore((s) => s.groups)
  const moveToGroup = useProfilesStore((s) => s.moveToGroup)
  const current = useProfilesStore((s) =>
    ids.length === 1 && ids[0] ? (s.byId[ids[0]]?.groupId ?? null) : null,
  )
  const [value, setValue] = useState<string | null>(current)
  const [saving, setSaving] = useState(false)

  const apply = async (): Promise<void> => {
    setSaving(true)
    await moveToGroup(ids, value)
    setSaving(false)
    onDone()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('moveToGroup.title')}</DialogTitle>
        <DialogDescription>{t('moveToGroup.description', { count: ids.length })}</DialogDescription>
      </DialogHeader>
      <Command className="rounded-lg border">
        {groups.length > 7 && <CommandInput placeholder={t('filters.searchOptions')} />}
        <CommandList className="max-h-[300px]">
          <CommandGroup>
            <CommandItem value="__none__" onSelect={() => setValue(null)}>
              <Check className={cn('size-4', value === null ? 'text-primary opacity-100' : 'opacity-0')} />
              <FolderX className="size-4 text-muted-foreground" />
              {t('common.noGroup')}
            </CommandItem>
            {groups.map((group) => (
              <CommandItem
                key={group.id}
                value={`${group.name} ${group.id}`}
                onSelect={() => setValue(group.id)}
              >
                <Check
                  className={cn('size-4', value === group.id ? 'text-primary opacity-100' : 'opacity-0')}
                />
                <GroupDot color={group.color} />
                {group.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void apply()} disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" />}
          {t('moveToGroup.apply')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function MoveToGroupDialog() {
  const state = useUiStore((s) => s.moveToGroup)
  const close = useUiStore((s) => s.closeMoveToGroup)
  return (
    <Dialog open={state.open} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        {state.open && <MoveToGroupBody ids={state.ids} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}
