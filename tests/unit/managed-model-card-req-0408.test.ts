import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ManagedModelCard,
  type ManagedModelCardProps,
  type ManagedCardState,
} from '../../src/renderer/components/ui/managed-model-card'

/**
 * REQ-0408 — the shared card that unifies the Whisper model picker and the
 * translation-tool section.  Pins the state → UI mapping so a refactor can't
 * silently drop a button or the green "in use" treatment.
 */

const LABELS = {
  download: 'DL',
  downloading: 'DLING',
  cancel: 'CANCEL',
  useThis: 'USE',
  selected: 'INUSE',
  installedBadge: 'INSTALLED',
  activeBadge: 'ACTIVE',
  recommended: 'REC',
  deleteTitle: 'DEL',
}

function markup(props: Partial<ManagedModelCardProps>): string {
  const full: ManagedModelCardProps = {
    title: 'Model X',
    sizeLabel: '1.2 GB',
    description: 'desc',
    state: 'not-downloaded',
    labels: LABELS,
    ...props,
  }
  return renderToStaticMarkup(React.createElement(ManagedModelCard, full))
}

describe('ManagedModelCard — state → UI (REQ-0408)', () => {
  it('not-downloaded → Download button only (no Use / no badge)', () => {
    const html = markup({ state: 'not-downloaded' })
    expect(html).toContain('DL')
    expect(html).not.toContain('USE')
    expect(html).not.toContain('INSTALLED')
    expect(html).not.toContain('ACTIVE')
  })

  it('downloaded (non-active) → Use + Delete + installed badge', () => {
    const html = markup({ state: 'downloaded' })
    expect(html).toContain('USE')
    expect(html).toContain('INSTALLED')
    expect(html).toContain('title="DEL"')
    expect(html).not.toContain('>DL<')
  })

  it('active → green tint + active badge + selected label', () => {
    const html = markup({ state: 'active', onDeselect: () => {} })
    expect(html).toContain('border-primary') // active tint on the card
    expect(html).toContain('ACTIVE') // top-right badge
    expect(html).toContain('INUSE') // active button label
    expect(html).toContain('title="DEL"') // delete still available
  })

  it('active without onDeselect → the selected button is disabled (Whisper behaviour)', () => {
    const html = markup({ state: 'active' })
    expect(html).toContain('INUSE')
    expect(html).toContain('disabled') // not clickable
  })

  it('downloading → progress %, cancel, and a progress bar sized to the percent', () => {
    const html = markup({ state: 'downloaded', isDownloading: true, downloadPercent: 70, downloadFile: 'model.bin' })
    expect(html).toContain('70%')
    expect(html).toContain('CANCEL')
    expect(html).toContain('width:70%')
    expect(html).toContain('model.bin') // current file shown
    // download-mode hides the Use/Delete actions
    expect(html).not.toContain('USE')
  })

  it('recommended chip shows only when recommended', () => {
    expect(markup({ recommended: true })).toContain('REC')
    expect(markup({ recommended: false })).not.toContain('REC')
  })

  it('renders the title, size and description verbatim', () => {
    const html = markup({ title: 'MADLAD 3B', sizeLabel: '約 3 GB', description: 'lightweight' })
    expect(html).toContain('MADLAD 3B')
    expect(html).toContain('約 3 GB')
    expect(html).toContain('lightweight')
  })
})

// Type-only: the three-state union is exhaustive for the mapping above.
const _states: ManagedCardState[] = ['not-downloaded', 'downloaded', 'active']
void _states
