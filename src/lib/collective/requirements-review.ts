/** An English comparison is valid only for this exact pair of readings. */
export type RequirementsReview = { english: string; hindi: string; back: string | null };

/** Edits and newer requests invalidate outstanding drafts, even if the English is later restored. */
export class RequirementsDraftSession {
  private revision = 0;
  begin(english: string) { return { revision: ++this.revision, english: english.trim() }; }
  invalidate() { this.revision++; }
  isCurrent(request: { revision: number }) { return request.revision === this.revision; }
}

export function currentBackTranslation(readings: { details: string; detailsHi: string }, review: RequirementsReview | null): string | null {
  return review && review.english === readings.details.trim() && review.hindi === readings.detailsHi.trim() ? review.back : null;
}
