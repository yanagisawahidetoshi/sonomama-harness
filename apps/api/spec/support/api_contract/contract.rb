# frozen_string_literal: true

module ApiContract
  Result = Data.define(:operation, :status, :request_violations, :response_violations, :undefined)

  # An OpenAPI 3.1 document and the operations a request spec can be checked against.
  class Contract
    METHODS = %w[get put post patch delete].freeze

    attr_reader :path, :document, :definition

    def self.load(path)
      path = Pathname(path)
      raise ContractError, "#{path} does not exist" unless path.exist?

      new(path, path.extname == ".json" ? JSON.parse(path.read) : YAML.safe_load_file(path, aliases: false))
    rescue JSON::ParserError, Psych::Exception => e
      raise ContractError, "#{path} cannot be read: #{e.class}"
    end

    def initialize(path, document)
      @path = path
      @document = document
      validate!
      @definition = OpenapiFirst.load(path.to_s)
      @schemer = JSONSchemer.openapi(document)
    end

    def operations
      paths.flat_map do |template, item|
        METHODS.select { |method| deref(item).key?(method) }.map { |method| "#{method.upcase} #{template}" }
      end
    end

    # request: the ActionDispatch::Request a request spec sent, response: the ActionDispatch::TestResponse it got.
    def check(request, response)
      rack_request = rebuild(request)
      method = rack_request.request_method.downcase
      template = template_for(rack_request.path, method)
      return undefined(request, response) unless template

      exchange = Exchange.new(self, template, method)
      Result.new(operation: "#{method.upcase} #{template}", status: response.status, undefined: false,
                 request_violations: exchange.request_violations(rack_request),
                 response_violations: exchange.response_violations(response))
    end

    # Follows local $refs between OpenAPI objects and returns the node with its JSON pointer.
    def locate(*tokens)
      tokens.reduce(follow(document, "")) do |(node, pointer), token|
        return [nil, nil] unless node.is_a?(Hash) && node.key?(token)

        follow(node[token], "#{pointer}/#{ERB::Util.url_encode(token.to_s.gsub('~', '~0').gsub('/', '~1'))}")
      end
    end

    def deref(node) = follow(node, "").first

    def schema_errors(pointer, data, access_mode)
      @schemer.ref("##{pointer}").validate(data, access_mode:).map do |error|
        at = error["data_pointer"].presence || "/"
        [at, "#{at}: #{error['error']}"]
      end
    end

    private

    def validate!
      version = document["openapi"] if document.is_a?(Hash)
      raise ContractError, "#{path} is not OpenAPI 3.1 (#{version.inspect})" unless version.to_s.start_with?("3.1.")

      reject!("uses features the contract check cannot validate", Unsupported.scan(document))
      reject!("is not a valid OpenAPI 3.1 document", dialect_errors)
    end

    # A schema value the OpenAPI 3.1 dialect rejects (type: strng) would otherwise validate nothing.
    # A misspelled keyword (requried) is an unknown keyword to JSON Schema and cannot be detected here.
    def dialect_errors
      JSONSchemer.openapi(document).validate.first(5).map { |error| "#{error['data_pointer']}: #{error['error']}" }
    end

    def reject!(reason, problems)
      raise ContractError, "#{path} #{reason}:\n#{problems.join("\n")}" if problems.any?
    end

    def paths = document.fetch("paths", nil) || {}

    def follow(node, pointer)
      while node.is_a?(Hash) && node["$ref"].is_a?(String)
        pointer = node["$ref"].delete_prefix("#")
        node = Hana::Pointer.new(pointer.gsub(/%\h\h/) { |escaped| escaped[1..].hex.chr }).eval(document)
      end
      [node, pointer]
    end

    # Exact paths win over templated ones, as in OpenAPI path matching.
    def template_for(request_path, method)
      candidates = paths.keys.select { |template| deref(paths[template]).key?(method) }
      candidates.find { |template| template == request_path } ||
        candidates.find { |template| request_path.match?(template_pattern(template)) }
    end

    def template_pattern(template)
      /\A#{template.split(/(\{[^}]+\})/).map { |part| part.start_with?('{') ? '[^/]+' : Regexp.escape(part) }.join}\z/
    end

    # Path parameter values (IDs, slugs) and segments with digits are masked; static names such as v1 stay readable.
    def undefined(request, response)
      values = request.path_parameters.except(:controller, :action, :format).values.map(&:to_s)
      path = request.path.split("/", -1).map do |segment|
        values.include?(segment) || !segment.match?(/\A(?:[A-Za-z_-]*|v\d+)\z/) ? ":param" : segment
      end
      Result.new(operation: "#{request.request_method} #{path.join('/')}", status: response.status,
                 request_violations: [], response_violations: [], undefined: true)
    end

    # A fresh Rack request from what the spec sent, independent of the body Rails already read.
    def rebuild(request)
      headers = request.env.select do |key, _|
        key.start_with?("HTTP_") || %w[CONTENT_TYPE CONTENT_LENGTH].include?(key)
      end
      options = { method: request.request_method, input: request.raw_post.to_s, "QUERY_STRING" => request.query_string }
      Rack::Request.new(Rack::MockRequest.env_for(request.path, headers.merge(options)))
    end
  end
end
