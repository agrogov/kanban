// Push-based async iterable. The Claude Agent SDK takes its streaming user input as an
// AsyncIterable, so follow-up messages are pushed here for as long as the session lives.
export class AsyncMessageQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private waiter: ((result: IteratorResult<T>) => void) | null = null;
	private closed = false;

	push(item: T): void {
		if (this.closed) {
			return;
		}
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			resolve({ value: item, done: false });
			return;
		}
		this.items.push(item);
	}

	close(): void {
		this.closed = true;
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item !== undefined) {
					return Promise.resolve({ value: item, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise<IteratorResult<T>>((resolve) => {
					this.waiter = resolve;
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}
