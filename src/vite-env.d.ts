/// <reference types="vite/client" />

interface TokenResponse {
  access_token: string
  expires_in: string
  error?: string
}

declare namespace google {
  namespace accounts {
    namespace oauth2 {
      interface TokenClient {
        callback: (response: TokenResponse) => void
        requestAccessToken(): void
      }
      function initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
      }): TokenClient
      function revoke(token: string, callback: () => void): void
    }
  }
}

declare namespace gapi {
  function load(api: string, callback: () => void): void

  namespace client {
    function init(config: { apiKey: string; discoveryDocs: string[] }): Promise<void>
    function setToken(token: { access_token: string }): void
    function request(config: {
      path: string
      method: string
      params?: Record<string, string>
      body?: unknown
    }): Promise<{ result: unknown; body?: string }>

    namespace drive {
      namespace files {
        function list(config?: {
          q?: string
          fields?: string
          spaces?: string
          orderBy?: string
          pageSize?: number
          pageToken?: string
        }): Promise<{
          result: {
            files: Array<{
              id: string
              name: string
              mimeType: string
              modifiedTime: string
            }>
            nextPageToken?: string
          }
        }>
        function get(config: { fileId: string; alt: string }): Promise<{ body: string }>
        function create(config: {
          resource: {
            name: string
            mimeType: string
            parents?: string[]
          }
          fields?: string
        }): Promise<{ result: { id: string } }>
        function update(config: {
          fileId: string
          resource: {
            name: string
            mimeType: string
          }
          media: {
            mimeType: string
            body: string
          }
          fields?: string
        }): Promise<{ result: { id: string } }>
      }
    }
  }
}
