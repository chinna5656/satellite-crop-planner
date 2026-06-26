class CropAnalysisError(Exception):
    """Base exception for expected crop analysis failures."""


class ImageryNotFoundError(CropAnalysisError):
    """Raised when the STAC search cannot find suitable imagery."""


class ImageryProcessingError(CropAnalysisError):
    """Raised when imagery exists but cannot be processed safely."""
