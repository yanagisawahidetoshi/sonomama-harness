# frozen_string_literal: true

module ApiContract
  # One request / response pair of a resolved operation, checked against the contract.
  # Messages carry pointers and keyword messages only, never the token, the body or the values it holds.
  class Exchange
    # Bodies and their media types are checked strictly below, not by openapi_first (it fills in schema defaults).
    BODY_FAILURES = %i[invalid_body unsupported_media_type].freeze

    def initialize(contract, template, method)
      @contract = contract
      @operation = ["paths", template, method]
      @route = contract.definition.routes.find do |route|
        route.path == template && route.request_method.casecmp?(method)
      end
    end

    def request_violations(rack_request)
      failure = @contract.definition.validate_request(rack_request).error
      parameters = failure && BODY_FAILURES.exclude?(failure.type) ? failure_messages("request", failure) : []
      rack_request.body.rewind
      parameters + request_body_violations(rack_request.media_type, rack_request.body.read.to_s)
    end

    def response_violations(response)
      status = status_key(response.status)
      return ["status #{response.status} is not declared (declared: #{declared_statuses})"] unless status

      content = @contract.deref(responses[status])&.fetch("content", nil)
      return bodyless_violations(response, status) if content.blank?

      media_type = response.media_type
      return [undeclared_media_type("response media type", media_type, content)] unless content.key?(media_type)

      response_body_violations(response, status, media_type)
    end

    private

    def responses = @contract.deref(@contract.locate(*@operation, "responses").first) || {}

    def declared_statuses = responses.keys.join(", ")

    def status_key(status)
      [status.to_s, "#{status / 100}XX", "#{status / 100}xx", "default"].find { |key| responses.key?(key) }
    end

    def bodyless_violations(response, status)
      body = response.body.empty? ? [] : ["status #{status} declares no body, but the response has one"]
      body + header_violations(response, response_definition(status, nil))
    end

    def request_body_violations(media_type, body)
      request_body, = @contract.locate(*@operation, "requestBody")
      return body.empty? ? [] : ["request body is sent, but the operation declares no request body"] unless request_body
      return request_body["required"] ? ["request body is required"] : [] if body.empty?

      content = request_body.fetch("content", {})
      return [undeclared_media_type("request body media type", media_type, content)] unless content.key?(media_type)

      body_violations("request body", ["requestBody", "content", media_type], body, "write")
    end

    def undeclared_media_type(label, media_type, content)
      "#{label} #{media_type.presence || '(none)'} is not declared (declared: #{content.keys.join(', ')})"
    end

    def body_violations(label, tokens, body, access_mode)
      _, pointer = @contract.locate(*@operation, *tokens, "schema")
      data = JSON.parse(body)
      return [] unless pointer

      @contract.schema_errors(pointer, data, access_mode).map { |message| "#{label} #{message}" }
    rescue JSON::ParserError
      ["#{label} is not valid JSON"]
    end

    def response_body_violations(response, status, media_type)
      body_violations("response body", ["responses", status, "content", media_type], response.body, "read") +
        header_violations(response, response_definition(status, media_type))
    end

    def response_definition(status, media_type)
      @route&.responses&.find { |candidate| [candidate.status, candidate.content_type] == [status, media_type] }
    end

    # Declared response headers are checked by openapi_first; its body result is ignored in favour of the strict check.
    def header_violations(response, definition)
      return [] if definition.nil? || definition.headers.blank?

      failure = definition.validate(Rack::Response.new([response.body], response.status, response.headers.to_h)).error
      failure&.type == :invalid_response_header ? failure_messages("response header", failure) : []
    end

    def failure_messages(label, failure)
      return ["#{label} #{failure.type}"] if failure.errors.blank?

      failure.errors.map { |error| "#{label} #{failure.type} #{error.data_pointer.presence || '/'}: #{error.message}" }
    end
  end
end
