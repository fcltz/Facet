import { zodResolver } from '@hookform/resolvers/zod'
import { Folder, LoaderCircle, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { DEFAULT_COLOR } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import { groupInputSchema, tagInputSchema, type GroupInput } from '@shared/schemas/group-tag'
import { ColorPicker } from '@renderer/components/common/ColorPicker'
import { Field } from '@renderer/components/common/Field'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { toastError } from '@renderer/lib/ipc'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

type CatalogKind = 'group' | 'tag'

interface CatalogItem {
  id: string
  name: string
  color: string
}

interface EditorState {
  kind: CatalogKind
  item: CatalogItem | null
}

/** Grupos e tags têm o mesmo formulário (nome + cor), cada um com o próprio limite de tamanho. */
function CatalogItemForm({ state, onDone }: { state: EditorState; onDone: () => void }) {
  const { t } = useTranslation()
  const createGroup = useCatalogStore((s) => s.createGroup)
  const updateGroup = useCatalogStore((s) => s.updateGroup)
  const createTag = useCatalogStore((s) => s.createTag)
  const updateTag = useCatalogStore((s) => s.updateTag)
  const form = useForm<GroupInput>({
    resolver: zodResolver(state.kind === 'group' ? groupInputSchema : tagInputSchema),
    defaultValues: { name: state.item?.name ?? '', color: state.item?.color ?? DEFAULT_COLOR },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (state.kind === 'group') {
        if (state.item) await updateGroup(state.item.id, values)
        else await createGroup(values)
      } else if (state.item) {
        await updateTag(state.item.id, values)
      } else {
        await createTag(values)
      }
      onDone()
    } catch (error) {
      const reason =
        error instanceof AppError ? (error.details as { reason?: string } | undefined)?.reason : undefined
      if (reason === 'duplicateName') form.setError('name', { message: 'duplicateName' })
      else toastError(error)
    }
  })

  const title =
    state.kind === 'group'
      ? state.item
        ? t('catalog.editGroupTitle')
        : t('catalog.createGroupTitle')
      : state.item
        ? t('catalog.editTagTitle')
        : t('catalog.createTagTitle')

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {state.kind === 'group' ? t('catalog.groupsHint') : t('catalog.tagsHint')}
        </DialogDescription>
      </DialogHeader>
      <Field label={t('catalog.name')} htmlFor="catalog-name" error={errors.name?.message}>
        <Input
          id="catalog-name"
          autoFocus
          autoComplete="off"
          {...form.register('name')}
          data-testid="catalog-name"
        />
      </Field>
      <Field label={t('catalog.color')}>
        <Controller
          control={form.control}
          name="color"
          render={({ field }) => (
            <ColorPicker value={field.value} onChange={(color) => field.onChange(color ?? DEFAULT_COLOR)} />
          )}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting} data-testid="catalog-submit">
          {isSubmitting && <LoaderCircle className="animate-spin" />}
          {state.item ? t('common.save') : t('common.create')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function CatalogCard({
  kind,
  icon,
  title,
  hint,
  items,
  counts,
  emptyLabel,
  newLabel,
  onEdit,
  onDelete,
}: {
  kind: CatalogKind
  icon: ReactNode
  title: string
  hint: string
  items: CatalogItem[]
  counts: Map<string, number>
  emptyLabel: string
  newLabel: string
  onEdit: (state: EditorState) => void
  onDelete: (item: CatalogItem) => void
}) {
  const { t } = useTranslation()
  return (
    <section
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-soft"
      data-testid={`catalog-${kind}`}
    >
      <header className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {icon}
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              {title} <span className="font-normal text-muted-foreground tabular-nums">· {items.length}</span>
            </h2>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        <Button size="sm" onClick={() => onEdit({ kind, item: null })} data-testid={`catalog-new-${kind}`}>
          <Plus />
          {newLabel}
        </Button>
      </header>
      {items.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {items.map((item) => (
            <li
              key={item.id}
              className="group flex items-center gap-3 px-5 py-2.5"
              data-testid={`catalog-item-${kind}`}
            >
              <span
                aria-hidden
                className={kind === 'group' ? 'size-3 rounded-[4px]' : 'size-2.5 rounded-full'}
                style={{ backgroundColor: item.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('catalog.profiles', { count: counts.get(item.id) ?? 0 })}
              </span>
              <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onEdit({ kind, item })}
                  aria-label={t('common.edit')}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onDelete(item)}
                  aria-label={t('common.delete')}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function GroupsTagsPage() {
  const { t } = useTranslation()
  const groups = useCatalogStore((s) => s.groups)
  const tags = useCatalogStore((s) => s.tags)
  const deleteGroup = useCatalogStore((s) => s.deleteGroup)
  const deleteTag = useCatalogStore((s) => s.deleteTag)
  const byId = useProfilesStore((s) => s.byId)
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const [editor, setEditor] = useState<EditorState | null>(null)

  const { groupCounts, tagCounts } = useMemo(() => {
    const groupCounts = new Map<string, number>()
    const tagCounts = new Map<string, number>()
    for (const profile of Object.values(byId)) {
      if (profile.deletedAt !== null) continue
      if (profile.groupId) groupCounts.set(profile.groupId, (groupCounts.get(profile.groupId) ?? 0) + 1)
      for (const tagId of profile.tagIds) tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1)
    }
    return { groupCounts, tagCounts }
  }, [byId])

  const confirmDeleteGroup = async (item: CatalogItem): Promise<void> => {
    const group = groups.find((g) => g.id === item.id)
    if (!group) return
    const confirmed = await requestConfirm({
      title: t('catalog.deleteGroupTitle', { name: group.name }),
      description: t('catalog.deleteGroupDescription'),
      confirmLabel: t('common.delete'),
      destructive: true,
    })
    if (confirmed) await deleteGroup(group)
  }

  const confirmDeleteTag = async (item: CatalogItem): Promise<void> => {
    const tag = tags.find((tg) => tg.id === item.id)
    if (!tag) return
    const confirmed = await requestConfirm({
      title: t('catalog.deleteTagTitle', { name: tag.name }),
      description: t('catalog.deleteTagDescription'),
      confirmLabel: t('common.delete'),
      destructive: true,
    })
    if (confirmed) await deleteTag(tag)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={t('catalog.title')} description={t('catalog.subtitle')} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-6 pb-6 lg:grid-cols-2">
        <CatalogCard
          kind="group"
          icon={<Folder className="size-[18px]" />}
          title={t('catalog.groups')}
          hint={t('catalog.groupsHint')}
          items={groups}
          counts={groupCounts}
          emptyLabel={t('catalog.emptyGroups')}
          newLabel={t('catalog.newGroup')}
          onEdit={setEditor}
          onDelete={(item) => void confirmDeleteGroup(item)}
        />
        <CatalogCard
          kind="tag"
          icon={<TagIcon className="size-[18px]" />}
          title={t('catalog.tags')}
          hint={t('catalog.tagsHint')}
          items={tags}
          counts={tagCounts}
          emptyLabel={t('catalog.emptyTags')}
          newLabel={t('catalog.newTag')}
          onEdit={setEditor}
          onDelete={(item) => void confirmDeleteTag(item)}
        />
      </div>
      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-md">
          {editor && (
            <CatalogItemForm
              key={`${editor.kind}:${editor.item?.id ?? 'new'}`}
              state={editor}
              onDone={() => setEditor(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
