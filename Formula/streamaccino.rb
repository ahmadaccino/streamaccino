# typed: false
# frozen_string_literal: true

class Streamaccino < Formula
  desc "Hero video encoder & Cloudflare R2 uploader"
  homepage "https://github.com/YOUR_USER/streamaccino"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/YOUR_USER/streamaccino/releases/download/v0.1.0/streamaccino-darwin-arm64.tar.gz"
      sha256 "e2fc9d96d6b4ebac9a5997e2d81d3ac42b1a498e526a9c44884d255c2fa313a3"
    else
      url "https://github.com/YOUR_USER/streamaccino/releases/download/v0.1.0/streamaccino-darwin-x64.tar.gz"
      sha256 "0d653cafcbc562d2b122813c32d6105960106c8026f4195497799a9dccc7aee5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/YOUR_USER/streamaccino/releases/download/v0.1.0/streamaccino-linux-arm64.tar.gz"
      sha256 "cae569d9f6c0e3f6c26340ac81c4330814b5f1c373fb1eac42015d92652db279"
    else
      url "https://github.com/YOUR_USER/streamaccino/releases/download/v0.1.0/streamaccino-linux-x64.tar.gz"
      sha256 "fb8d5b8c992e8f14641b9658f6d73078708f9463d58fda77db8fa848690b9b1a"
    end
  end

  depends_on "ffmpeg"

  def install
    bin.install "streamaccino"
  end

  test do
    assert_match "streamaccino v#{version}", shell_output("#{bin}/streamaccino --version")
  end
end
