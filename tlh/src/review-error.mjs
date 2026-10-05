// Only intentional user-facing validation errors may cross the HTTP boundary.
export class ReviewError extends Error { constructor(message){super(message);this.name='ReviewError';} }
