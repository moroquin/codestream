export interface Directives {
	directives: {
		type:
			| "addApprovedBy"
			| "addNode"
			| "addNodes"
			| "addReaction"
			| "removeNode"
			| "removeReaction"
			| "removeApprovedBy"
			| "resolveReviewThread"
			| "setLabels"
			| "unresolveReviewThread"
			| "updateDiscussionNote"
			| "updateNode"
			| "updatePullRequest"
			| "updatePullRequestReview"
			| "updatePullRequestReviewers"
			| "updatePullRequestReviewComment"
			| "updatePullRequestReviewCommentNode";
		data: any;
	}[];
}
