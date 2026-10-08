import { searchInput, type SearchInput, type SearchResponse, type SearchService } from '../Services/SearchService';

export const searchArtifactsInput = searchInput;
export type SearchArtifactsInput = SearchInput;

export class SearchArtifactsAction {
  constructor(private readonly search: SearchService) {}

  execute(input: SearchInput): SearchResponse {
    return this.search.search(searchInput.parse(input));
  }
}
