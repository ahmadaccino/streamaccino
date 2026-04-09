# typed: false
# frozen_string_literal: true

class Streamaccino < Formula
  desc "Hero video encoder & Cloudflare R2 uploader"
  homepage "https://github.com/ahmadaccino/streamaccino"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/ahmadaccino/streamaccino/releases/download/v0.1.0/streamaccino-darwin-arm64.tar.gz"
      sha256 "2b312094c6c401a72c90346ee7f8159741ac5f4e9ff3f9cff5f616cd2c981104"
    else
      url "https://github.com/ahmadaccino/streamaccino/releases/download/v0.1.0/streamaccino-darwin-x64.tar.gz"
      sha256 "ca384e9b1d72307fe978c78a30d46562618c9c6eabccaceb6e8a517e25031b55"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/ahmadaccino/streamaccino/releases/download/v0.1.0/streamaccino-linux-arm64.tar.gz"
      sha256 "e60474efcc56ce253b20e0fd79120c0913e7e7c6d6a705bdab26bb05a7bafe1d"
    else
      url "https://github.com/ahmadaccino/streamaccino/releases/download/v0.1.0/streamaccino-linux-x64.tar.gz"
      sha256 "1daab933056f871ff0dfe3d10f2435b708eb7ac54a1419e93021b18a40fa6ab9"
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
