# Edge worker source origin

This V2 repository is the active edge-router source. It was selectively imported
from the frozen pre-V2 worker snapshot and then reconciled for the new V2-only
topology. The frozen source remains outside the active V2 tree for reference and
rollback; it is not a deployment target.

The active worker forwards only to the V2 Vercel project and contains no AWS,
legacy Vercel or customer-selected origin.
