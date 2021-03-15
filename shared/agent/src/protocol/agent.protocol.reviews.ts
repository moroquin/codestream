"use strict";
import { RequestType, TextDocumentIdentifier } from "vscode-languageserver-protocol";
import { CreateMarkerRequest, PostPlus } from "./agent.protocol";
import {
	CSChannelStream,
	CSCreateReviewRequest,
	CSDirectStream,
	CSGetReviewDiffsRequest,
	CSGetReviewDiffsResponse,
	CSGetReviewsResponse,
	CSMarker,
	CSMarkerLocations,
	CSRepoChange,
	CSRepository,
	CSReview,
	CSReviewChangesetBase,
	CSReviewCheckpoint,
	CSStream,
	CSUpdateReviewRequest,
	CSUpdateReviewResponse
} from "./api.protocol";
import {
	CSReviewChangeset,
	CSReviewDiffs,
	CSReviewStatus,
	ReviewChangesetFileInfo
} from "./api.protocol.models";

export interface ReviewPlus extends CSReview {}

export interface CreateDiffsRequest extends CSReviewDiffs {}
export interface CreateReviewChangesetsRequest
	extends Omit<CSReviewChangesetBase, "reviewId" | "repoId" | "diffId"> {
	repoId: string;
	diffs: CreateDiffsRequest;
}

export interface CreateReviewRequest extends Omit<CSCreateReviewRequest, "teamId"> {
	markers?: CreateMarkerRequest[];
	reviewChangesets?: CreateReviewChangesetsRequest[];
}

export interface CreateReviewResponse {
	review: CSReview;
	markers?: CSMarker[];
	markerLocations?: CSMarkerLocations[];
	streams?: CSStream[];
	repos?: CSRepository[];
}
export const CreateReviewRequestType = new RequestType<
	CreateReviewRequest,
	CreateReviewResponse,
	void,
	void
>("codestream/reviews/create");

export interface ShareableReviewAttributes extends Omit<CreateReviewRequest, "markers"> {}

export interface CreateShareableReviewRequest {
	attributes: ShareableReviewAttributes;
	memberIds?: string[];
	textDocuments?: TextDocumentIdentifier[];
	entryPoint?: string;
	mentionedUserIds?: string[];
	addedUsers?: string[];
}

export interface CreateShareableReviewResponse {
	review: ReviewPlus;
	post: PostPlus;
	stream: CSDirectStream | CSChannelStream;
	markerLocations?: CSMarkerLocations[];
}

export const CreateShareableReviewRequestType = new RequestType<
	CreateShareableReviewRequest,
	CreateShareableReviewResponse,
	void,
	void
>("codestream/reviews/create");

export interface FetchReviewsRequest {
	reviewIds?: string[];
	streamId?: string;
	before?: number;
	byLastAcivityAt?: boolean;
}

// TODO: when the server starts returning the markers, this response should have ReviewPlus objects
export type FetchReviewsResponse = Pick<CSGetReviewsResponse, "reviews">;

export const FetchReviewsRequestType = new RequestType<
	FetchReviewsRequest,
	FetchReviewsResponse,
	void,
	void
>("codestream/reviews");

export interface DeleteReviewRequest {
	id: string;
}
export interface DeleteReviewResponse {}
export const DeleteReviewRequestType = new RequestType<
	DeleteReviewRequest,
	DeleteReviewResponse,
	void,
	void
>("codestream/review/delete");

export interface GetReviewRequest {
	reviewId: string;
}

export interface GetReviewResponse {
	review: CSReview;
}

export const GetReviewRequestType = new RequestType<
	GetReviewRequest,
	GetReviewResponse,
	void,
	void
>("codestream/review");

export interface SetReviewStatusRequest {
	id: string;
	status: string;
}
export interface SetReviewStatusResponse {
	review: ReviewPlus;
}
export const SetReviewStatusRequestType = new RequestType<
	SetReviewStatusRequest,
	SetReviewStatusResponse,
	void,
	void
>("codestream/review/setStatus");

export interface UpdateReviewRequest extends CSUpdateReviewRequest {
	id: string;
	/**
	 * This property is set from the client, then transformed into
	 * `$addToSet.reviewChangesets`
	 *
	 * @serverIgnore this property can be deleted before it is sent to the server
	 */
	repoChanges?: CSRepoChange[];
}

export interface UpdateReviewResponse extends CSUpdateReviewResponse {}

export const UpdateReviewRequestType = new RequestType<
	UpdateReviewRequest,
	UpdateReviewResponse,
	void,
	void
>("codestream/review/update");

export interface FollowReviewRequest {
	id: string;
	value: boolean;
}
export interface FollowReviewResponse {}
export const FollowReviewRequestType = new RequestType<
	FollowReviewRequest,
	FollowReviewResponse,
	void,
	void
>("codestream/review/follow");

export interface GetReviewContentsRequest {
	reviewId: string;
	repoId: string;
	path: string;
	checkpoint: CSReviewCheckpoint;
}

export interface GetReviewContentsLocalRequest {
	repoId: string;
	path: string;
	oldPath?: string;
	editingReviewId?: string;
	baseSha: string;
	rightVersion: string;
}

export interface GetReviewContentsResponse {
	repoRoot?: string;
	left?: string;
	right?: string;
	fileNotIncludedInReview?: boolean;
	error?: string;
}

export const GetReviewContentsRequestType = new RequestType<
	GetReviewContentsRequest,
	GetReviewContentsResponse,
	void,
	void
>("codestream/review/contents");

export const GetReviewContentsLocalRequestType = new RequestType<
	GetReviewContentsLocalRequest,
	GetReviewContentsResponse,
	void,
	void
>("codestream/review/contentsLocal");

export interface GetAllReviewContentsRequest {
	reviewId: string;
	checkpoint: CSReviewCheckpoint;
}

export interface ReviewFileContents {
	leftPath: string;
	rightPath: string;
	path: string; // FIXME remove when all IDEs move to leftPath and rightPath
	left: string;
	right: string;
}

export interface GetReviewCoverageRequest {
	textDocument: TextDocumentIdentifier;
}

export interface GetReviewCoverageResponse {
	reviewIds: (string | undefined)[];
}

export const GetReviewCoverageRequestType = new RequestType<
	GetReviewCoverageRequest,
	GetReviewCoverageResponse,
	void,
	void
>("codestream/review/coverage");

export interface ReviewRepoContents {
	repoId: string;
	files: ReviewFileContents[];
}

export interface GetAllReviewContentsResponse {
	repos: ReviewRepoContents[];
}

export const GetAllReviewContentsRequestType = new RequestType<
	GetAllReviewContentsRequest,
	GetAllReviewContentsResponse,
	void,
	void
>("codestream/review/allContents");

export interface FetchReviewDiffsRequest extends CSGetReviewDiffsRequest {}

export interface FetchReviewDiffsResponse extends CSGetReviewDiffsResponse {}

export const FetchReviewDiffsRequestType = new RequestType<
	FetchReviewDiffsRequest,
	FetchReviewDiffsResponse,
	void,
	void
>("codestream/review/diffs");

export interface FetchReviewCheckpointDiffsRequest extends CSGetReviewDiffsRequest {}

export interface FetchReviewCheckpointDiffsResponse
	extends Array<{
		repoId: string;
		checkpoint: CSReviewCheckpoint;
		diffs: CSReviewDiffs;
	}> {}

export const FetchReviewCheckpointDiffsRequestType = new RequestType<
	FetchReviewCheckpointDiffsRequest,
	FetchReviewCheckpointDiffsResponse,
	void,
	void
>("codestream/review/checkpoint-diffs");

export interface CheckReviewPreconditionsRequest {
	reviewId: string;
}

export interface CheckReviewPreconditionsResponse {
	success: boolean;
	repoRoots?: {
		[repoId: string]: string;
	};
	error?: {
		message: string;
		type: "REPO_NOT_FOUND" | "REPO_NOT_OPEN" | "COMMIT_NOT_FOUND" | "UNKNOWN" | string;
	};
}

export const CheckReviewPreconditionsRequestType = new RequestType<
	CheckReviewPreconditionsRequest,
	CheckReviewPreconditionsResponse,
	void,
	void
>("codestream/review/checkPreconditions");

export interface CheckPullRequestBranchPreconditionsRequest {
	reviewId?: string; // either a reviewId or repoId need to be passed in
	repoId?: string;
	providerId: string;
	headRefName?: string;
	baseRefName?: string;
}

export interface CheckPullRequestBranchPreconditionsResponse {
	success: boolean;
	remote?: string;
	providerId?: string;

	error?: {
		message?: string;
		type?: "REPO_NOT_FOUND" | "ALREADY_HAS_PULL_REQUEST" | "UNKNOWN" | "PROVIDER" | string;
		url?: string;
	};
}

export const CheckPullRequestBranchPreconditionsRequestType = new RequestType<
	CheckPullRequestBranchPreconditionsRequest,
	CheckPullRequestBranchPreconditionsResponse,
	void,
	void
>("codestream/review/pr/branch/checkPreconditions");

export interface CheckPullRequestPreconditionsRequest {
	reviewId?: string;
	repoId?: string;
	headRefName?: string;
	baseRefName?: string;
	providerId?: string;
	skipLocalModificationsCheck?: boolean;
}

export interface CheckPullRequestPreconditionsResponse {
	success: boolean;
	review?: Pick<CSReview, "title" | "text">;
	repoId?: string;
	remoteUrl?: string;
	remoteBranch?: string;
	providerId?: string;
	remotes?: any[];
	origins?: string[];
	pullRequestProvider?: { defaultBranch?: string; isConnected: boolean };
	branch?: string;
	branches?: string[];
	remoteBranches?: string[];
	pullRequestTemplate?: string;
	pullRequestTemplateNames?: string[];
	pullRequestTemplatePath?: string;
	commitsBehindOriginHeadBranch?: string;
	warning?: {
		message?: string;
		type?: "ALREADY_HAS_PULL_REQUEST" | string;
		url?: string;
		id?: string;
	};
	error?: {
		message?: string;
		type?:
			| "REPO_NOT_FOUND"
			| "HAS_LOCAL_COMMITS"
			| "REQUIRES_PROVIDER"
			| "REQUIRES_PROVIDER_REPO"
			| "UNKNOWN"
			| string;
		url?: string;
		id?: string;
	};
}

export const CheckPullRequestPreconditionsRequestType = new RequestType<
	CheckPullRequestPreconditionsRequest,
	CheckPullRequestPreconditionsResponse,
	void,
	void
>("codestream/review/pr/checkPreconditions");

export interface CreatePullRequestRequest {
	/** if a reviewId isn't provided, you must provide a repoId */
	reviewId?: string;
	repoId?: string;
	providerId: string;
	title: string;
	description?: string;
	baseRefName: string;
	headRefName: string;
	providerRepositoryId?: string /* for use across forks */;
	remote: string /* to look up the repo ID on the provider */;
	remoteName?: string;
	addresses?: {
		title: string;
		url: string;
	}[];
	ideName?: string;
}

export interface CreatePullRequestResponse {
	success: boolean;
	url?: string;
	id?: string;
	error?: {
		type:
			| "REPO_NOT_FOUND"
			| "COMMIT_NOT_FOUND"
			| "BRANCH_REMOTE_CREATION_FAILED"
			| "UNKNOWN"
			| string;
		message?: string;
		url?: string;
		id?: string;
	};
}

export const CreatePullRequestRequestType = new RequestType<
	CreatePullRequestRequest,
	CreatePullRequestResponse,
	void,
	void
>("codestream/review/pr/create");

export interface StartReviewRequest {
	reviewId: string;
}

export interface StartReviewResponse {
	success: boolean;
	error?: string;
}

export const StartReviewRequestType = new RequestType<
	StartReviewRequest,
	StartReviewResponse,
	void,
	void
>("codestream/review/start");

export interface PauseReviewRequest {
	reviewId: string;
}

export interface PauseReviewResponse {
	success: boolean;
	error?: string;
}

export const PauseReviewRequestType = new RequestType<
	PauseReviewRequest,
	PauseReviewResponse,
	void,
	void
>("codestream/review/pause");

export interface EndReviewRequest {
	reviewId: string;
}

export interface EndReviewResponse {
	success: boolean;
	error?: string;
}

export const EndReviewRequestType = new RequestType<
	EndReviewRequest,
	EndReviewResponse,
	void,
	void
>("codestream/review/end");

export interface CreateReviewsForUnreviewedCommitsRequest {
	sequence: number;
}

export interface CreateReviewsForUnreviewedCommitsResponse {
	reviewIds: string[];
}

export const CreateReviewsForUnreviewedCommitsRequestType = new RequestType<
	CreateReviewsForUnreviewedCommitsRequest,
	CreateReviewsForUnreviewedCommitsResponse,
	void,
	void
>("codestream/review/createForUnreviewedCommits");
