import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { OPTIONAL_PROFILE_COLUMNS } from '@shared/schemas/profile-table'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@renderer/components/ui/dropdown-menu'
import { useProfileTableStore } from '@renderer/stores/profile-table.store'

export function ProfileViewMenu() {
  const { t } = useTranslation()
  const { preferences, setVisible, reset } = useProfileTableStore()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto h-9" data-testid="profile-view">
          <SlidersHorizontal />
          {t('profileView.title')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('profileView.columns')}</DropdownMenuLabel>
        {OPTIONAL_PROFILE_COLUMNS.map((id) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={!preferences.hidden.includes(id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => setVisible(id, checked)}
            data-testid={`view-${id}`}
          >
            {t(`profiles.columns.${id}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={reset} data-testid="view-reset">
          {t('profileView.reset')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
