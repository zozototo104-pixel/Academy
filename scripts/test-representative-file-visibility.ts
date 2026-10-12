import assert from 'node:assert/strict'
import { serializeRepresentative } from '../src/lib/academy-representatives'

const representative = {
  id: 'rep-1', slug: 'rep-one', status: 'ACTIVE', fullName: 'Example', country: 'Country', region: 'Region',
  files: [
    { id: 'pending-1', kind: 'FILE', title: 'Pending', reviewStatus: 'PENDING_REVIEW', storageProvider: 's3', storageKey: 'representatives/rep-1/pending.pdf', fileUrl: 'https://public.example.com/old-pending.pdf' },
    { id: 'rejected-1', kind: 'FILE', title: 'Rejected', reviewStatus: 'REJECTED', storageProvider: 's3', storageKey: 'representatives/rep-1/rejected.pdf', fileUrl: 'https://public.example.com/old-rejected.pdf' },
    { id: 'approved-1', kind: 'FILE', title: 'Approved', reviewStatus: 'APPROVED', storageProvider: 's3', storageKey: 'representatives-private/rep-1/approved.pdf', fileUrl: 'https://public.example.com/old-approved.pdf' },
  ],
}

const publicProfile = serializeRepresentative(representative)
assert.deepEqual(publicProfile.files?.map((file) => file.id), ['approved-1'], 'Only approved files may appear in public profiles')
assert.equal(publicProfile.files?.[0]?.fileUrl, '/api/representatives/rep-one/files/approved-1', 'Public files must use the access-controlled API')
assert.ok(!JSON.stringify(publicProfile).includes('old-pending.pdf'), 'Public response must not leak pending storage URLs')

const adminProfile = serializeRepresentative(representative, undefined, true)
assert.deepEqual(adminProfile.files?.map((file) => file.id), ['pending-1', 'rejected-1', 'approved-1'])
assert.equal(adminProfile.files?.[0]?.fileUrl, '/api/admin/representatives/rep-1/files/pending-1', 'Pending files should use authenticated admin preview')
assert.equal(adminProfile.files?.[1]?.fileUrl, '/api/admin/representatives/rep-1/files/rejected-1')
assert.ok(!JSON.stringify(adminProfile).includes('public.example.com'), 'Admin response must not expose legacy direct storage URLs')

console.log('Representative file visibility checks passed')
