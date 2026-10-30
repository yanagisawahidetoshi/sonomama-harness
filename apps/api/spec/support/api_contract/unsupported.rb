# frozen_string_literal: true

module ApiContract
  # Contract features the check cannot validate. Each one fails loading the contract instead of passing silently.
  module Unsupported
    JSON_MEDIA_TYPE = %r{\Aapplication/(?:[\w.-]+\+)?json\z}
    KNOWN_FORMATS = (JSONSchemer::Draft202012::FORMATS.keys + JSONSchemer::OpenAPI31::FORMATS.keys).freeze
    # Keys whose values are data, not OpenAPI objects or schema keywords.
    DATA_KEYS = %w[example examples default enum const].freeze
    # Maps whose keys are names (a property, a status such as default, a header such as x-trace-id), so no key is
    # skipped as data or as an x- extension there.
    NAME_MAPS = %w[
      properties patternProperties $defs definitions dependentSchemas schemas responses headers parameters
      requestBodies securitySchemes links callbacks content paths
    ].freeze
    # Objects whose `content` maps media types to schemas: request bodies, responses, parameters and headers.
    CONTENT_OWNER = %r{/(?:requestBody|requestBodies/[^/]+|responses/[^/]+|parameters/[^/]+|headers/[^/]+)\z}

    module_function

    def scan(node, pointer = "", found = [], key = nil)
      case node
      when Hash
        found.concat(problems(node, pointer))
        node.each do |child_key, child|
          scan(child, "#{pointer}/#{child_key}", found, child_key) unless skip?(child_key, key)
        end
      when Array then node.each_with_index { |child, index| scan(child, "#{pointer}/#{index}", found) }
      end
      found
    end

    def problems(node, pointer)
      [external_ref(node["$ref"]), unknown_format(node["format"]), *media_types(node, pointer)]
        .compact.map { |problem| "#{pointer}: #{problem}" }
    end

    def external_ref(ref)
      "external $ref #{ref} (only local #/ references)" if ref.is_a?(String) && !ref.start_with?("#")
    end

    def unknown_format(format)
      "format #{format} is unknown to the validator" if format.is_a?(String) && KNOWN_FORMATS.exclude?(format)
    end

    def media_types(node, pointer)
      return [] unless node["content"].is_a?(Hash) && pointer.match?(CONTENT_OWNER)

      node["content"].keys.grep_v(JSON_MEDIA_TYPE).map { |media_type| "media type #{media_type} (only JSON bodies)" }
    end

    def skip?(key, parent)
      return false if NAME_MAPS.include?(parent)

      DATA_KEYS.include?(key) || key.to_s.start_with?("x-")
    end
  end
end
